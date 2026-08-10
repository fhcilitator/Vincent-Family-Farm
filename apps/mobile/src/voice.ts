import { useCallback, useRef, useState } from 'react';
import { Platform } from 'react-native';
import {
  ExpoSpeechRecognitionModule,
  supportsOnDeviceRecognition,
  useSpeechRecognitionEvent,
} from '@jamsch/expo-speech-recognition';
import { applyDictation, appendDictation } from '@vff/client-core';

/**
 * Android 13 (API 33) is where `SpeechRecognizer` gained continuous
 * recognition. Below it, the recognizer stops at the first pause and plays the
 * start/stop beep it hardcodes — so the mode is detected at runtime rather
 * than assumed, and a phone on Android 12 gets a working single-utterance
 * button instead of a broken continuous one.
 */
export const supportsContinuous = Platform.OS === 'android' && Number(Platform.Version) >= 33;

/**
 * Whether recognition can run entirely on the phone.
 *
 * Worth surfacing rather than hiding: it is the difference between audio that
 * never leaves the device and audio sent to Google's servers, and the user is
 * dictating things like "push the release branch to production".
 */
export const onDevice = supportsOnDeviceRecognition();

export interface VoiceState {
  listening: boolean;
  /** Live partial transcript, shown while speaking and never sent on its own. */
  partial: string;
  error: string | null;
}

/**
 * Push-to-talk dictation.
 *
 * Two rules are structural rather than stylistic:
 *
 *  - **The transcript never auto-submits.** It lands in the composer for you
 *    to read and correct. A misheard instruction to an agent that runs bash is
 *    a bad failure and one tap prevents it.
 *  - **Voice composes prompts; taps authorize actions.** Nothing here can
 *    reach the permission sheet. The gate is only worth having if approving is
 *    a deliberate act.
 *
 * `onText` receives the corrected text merged onto whatever is already in the
 * composer, so speaking twice with a hand edit in between keeps the edit.
 */
export function useVoice(onText: (next: string) => void, currentText: () => string) {
  const [state, setState] = useState<VoiceState>({ listening: false, partial: '', error: null });
  // Held in a ref because the recognizer's callbacks fire outside React's
  // update cycle and must see the latest committed text, not a stale closure.
  const committed = useRef('');

  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results[0]?.transcript ?? '';
    if (!transcript) return;

    if (!event.isFinal) {
      setState((s) => ({ ...s, partial: transcript }));
      return;
    }
    const corrected = applyDictation(transcript);
    const merged = appendDictation(committed.current, corrected);
    committed.current = merged;
    setState((s) => ({ ...s, partial: '' }));
    onText(merged);
  });

  useSpeechRecognitionEvent('error', (event) => {
    setState({ listening: false, partial: '', error: describeError(event.error) });
  });

  useSpeechRecognitionEvent('end', () => {
    setState((s) => ({ ...s, listening: false, partial: '' }));
  });

  const start = useCallback(async () => {
    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setState({
        listening: false,
        partial: '',
        error: 'Microphone access is needed to dictate. Enable it in Settings.',
      });
      return;
    }

    committed.current = currentText();
    setState({ listening: true, partial: '', error: null });

    ExpoSpeechRecognitionModule.start({
      lang: 'en-US',
      interimResults: true,
      continuous: supportsContinuous,
      // On-device where the language pack is present, which keeps audio off
      // the network. Where it isn't, Android's default recognizer sends audio
      // to Google — so this is a preference, not a guarantee, and the Play
      // Data Safety disclosure has to say so rather than claiming audio never
      // leaves the phone. `onDevice` below reports which one is in use.
      requiresOnDeviceRecognition: onDevice,
      addsPunctuation: true,
    });
  }, [currentText]);

  const stop = useCallback(() => {
    ExpoSpeechRecognitionModule.stop();
    setState((s) => ({ ...s, listening: false }));
  }, []);

  return { ...state, start, stop };
}

function describeError(code: string): string {
  switch (code) {
    case 'not-allowed':
      return 'Microphone permission was denied.';
    case 'no-speech':
      return "Didn't catch that — try again.";
    case 'network':
      return 'Speech recognition needs a network connection on this device.';
    case 'language-not-supported':
      return 'This language pack is not installed on the phone.';
    default:
      return `Dictation failed (${code}).`;
  }
}
