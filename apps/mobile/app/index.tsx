import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import type { ChatItem } from '@vff/client-core';
import type { PermissionMode } from '@vff/protocol';
import { useConnection } from '../src/connection';
import { PermissionSheet } from '../src/components/PermissionSheet';
import { useVoice, onDevice } from '../src/voice';
import { C, TAP_MIN } from '../src/theme';

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [draft, setDraft] = useState('');
  const [mode, setMode] = useState<PermissionMode>('default');
  const listRef = useRef<FlatList<ChatItem>>(null);
  // The recognizer's callbacks fire outside React's update cycle, so it reads
  // the draft through a ref rather than capturing a stale one.
  const draftRef = useRef('');
  draftRef.current = draft;

  // Dictation only ever fills the composer. It cannot send, and it cannot
  // reach the permission sheet.
  const voice = useVoice(setDraft, () => draftRef.current);

  const {
    config,
    state,
    hello,
    chat,
    sessionId,
    error,
    restore,
    startSession,
    send,
    respond,
    interrupt,
  } = useConnection();

  useEffect(() => {
    void restore().then((paired) => {
      if (!paired) router.push('/connect');
    });
  }, [restore, router]);

  // One ask at a time. Two sheets stacked over each other is how you approve
  // the wrong one.
  const ask = useMemo(() => Object.values(chat.pendingPermissions)[0] ?? null, [chat.pendingPermissions]);

  const onSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void send(text);
  }, [draft, send]);

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      <Header
        state={state}
        tier={hello?.tier ?? null}
        rateLimit={chat.rateLimit?.summary ?? null}
        agentName={config?.name ?? null}
        onPressAgent={() => router.push('/connect')}
      />

      {hello && !hello.claudeAuth.usable && (
        <Banner
          title="Claude is not signed in on the dev box"
          detail={hello.claudeAuth.detail}
          remedy={hello.claudeAuth.remedy}
        />
      )}
      {chat.authTrouble && (
        <Banner title="Claude auth problem" detail={chat.authTrouble.message} remedy={chat.authTrouble.remedy} />
      )}
      {error && <Banner title="Connection" detail={error} remedy={null} />}

      <FlatList
        ref={listRef}
        style={s.list}
        data={chat.items}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <Item item={item} />}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <Text style={s.empty}>
            {sessionId ? 'Say what you want built.' : 'Start a session to begin.'}
          </Text>
        }
      />

      <KeyboardAvoidingView behavior="padding">
        <View style={[s.composer, { paddingBottom: insets.bottom + 8 }]}>
          {!sessionId ? (
            <>
              <ModePicker
                allowed={hello?.policy.allowedPermissionModes ?? []}
                selected={mode}
                onSelect={setMode}
              />
              <Pressable
                style={[s.primary, state !== 'live' && s.disabled]}
                disabled={state !== 'live'}
                onPress={() => void startSession(mode)}
              >
                <Text style={s.primaryText}>
                  {state === 'live' ? 'Start a session' : `Connecting… (${state})`}
                </Text>
              </Pressable>
            </>
          ) : (
            <View style={s.composerRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={voice.listening ? 'Stop dictating' : 'Dictate a prompt'}
                style={[s.mic, voice.listening && s.micLive]}
                // Push to talk: no wake word, no ambient recording, and the
                // mic is only ever live while a finger is on it.
                onPressIn={() => void voice.start()}
                onPressOut={voice.stop}
              >
                <Text style={s.micText}>{voice.listening ? '●' : '🎙'}</Text>
              </Pressable>
              <TextInput
                style={s.input}
                value={draft}
                onChangeText={setDraft}
                placeholder="Message Claude…"
                placeholderTextColor={C.dim}
                multiline
                // A prompt is mostly code and paths. Autocorrect turns
                // `useEffect` into `use effect` and a wrong instruction to an
                // agent that runs bash is a bad failure.
                autoCorrect={false}
                autoCapitalize="none"
                spellCheck={false}
              />
              <Pressable style={s.send} onPress={onSend}>
                <Text style={s.sendText}>Send</Text>
              </Pressable>
            </View>
          )}
          {/*
            The live transcript is shown separately from the composer so it is
            obvious that nothing has been committed yet — and it is never sent
            on its own. Final text lands in the box above, editable.
          */}
          {voice.listening && (
            <Text style={s.partial}>
              {voice.partial || (onDevice ? 'Listening (on device)…' : 'Listening…')}
            </Text>
          )}
          {voice.error && <Text style={s.voiceError}>{voice.error}</Text>}

          {chat.thinking && (
            <Pressable style={s.stop} onPress={() => void interrupt()}>
              <Text style={s.stopText}>Working… tap to stop</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>

      <PermissionSheet ask={ask} onDecide={(id, allow) => void respond(id, allow)} />
    </View>
  );
}

function Header({
  state,
  tier,
  rateLimit,
  agentName,
  onPressAgent,
}: {
  state: string;
  tier: string | null;
  rateLimit: string | null;
  agentName: string | null;
  onPressAgent: () => void;
}) {
  return (
    <View style={s.header}>
      <Pressable onPress={onPressAgent} style={s.agentButton}>
        <Text style={s.agentName}>{agentName ?? 'No agent'}</Text>
      </Pressable>
      <Badge text={state} color={state === 'live' ? C.ok : state === 'disconnected' ? C.danger : C.warn} />
      {/*
        The tier badge is not decoration. Behaviour visibly changes between
        tiers — more approval prompts, shorter timeouts — and an unexplained
        change in behaviour reads as a bug.
      */}
      {tier && <Badge text={tier} color={tier === 'trusted' ? C.ok : C.warn} />}
      {/*
        Rate-limit headroom, not cost: auth is a Pro/Max subscription, so a
        per-turn dollar figure would be meaningless. This is the number that
        actually stops a run.
      */}
      {rateLimit && <Badge text={rateLimit} color={C.surfaceAlt} />}
    </View>
  );
}

const MODE_BLURB: Record<string, string> = {
  default: 'Approve each tool call',
  plan: 'Plan only, no changes',
  auto: 'Runs without prompting',
  acceptEdits: 'File edits auto-approved',
  dontAsk: 'No prompts at all',
  bypassPermissions: 'All gates off',
};

/**
 * Permission mode chips, built from what the agent said it allows.
 *
 * Driven off `hello.policy.allowedPermissionModes` rather than a list in the
 * app, for two reasons: the picker can never offer a mode the agent will
 * refuse — which would turn a mode choice into a failed session start — and
 * the set legitimately differs by tier, so a hardcoded list would be wrong on
 * one path or the other no matter which list was chosen.
 */
function ModePicker({
  allowed,
  selected,
  onSelect,
}: {
  allowed: readonly PermissionMode[];
  selected: PermissionMode;
  onSelect: (m: PermissionMode) => void;
}) {
  if (allowed.length <= 1) return null;
  return (
    <View style={s.modes}>
      {allowed.map((m) => {
        const active = m === selected;
        return (
          <Pressable
            key={m}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[s.mode, active && s.modeActive]}
            onPress={() => onSelect(m)}
          >
            <Text style={[s.modeName, active && s.modeNameActive]}>{m}</Text>
            {MODE_BLURB[m] && <Text style={s.modeBlurb}>{MODE_BLURB[m]}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <View style={[s.badge, { backgroundColor: color }]}>
      <Text style={s.badgeText}>{text}</Text>
    </View>
  );
}

function Banner({
  title,
  detail,
  remedy,
}: {
  title: string;
  detail: string;
  remedy: string | null;
}) {
  return (
    <View style={s.banner}>
      <Text style={s.bannerTitle}>{title}</Text>
      <Text style={s.bannerText}>{detail}</Text>
      {/*
        The remedy is a command to run, and phase 5 puts a real terminal in
        this app — so the fix is one screen away rather than a trip to a
        desktop. Selectable so it can be copied in the meantime.
      */}
      {remedy && (
        <Text selectable style={s.bannerCode}>
          {remedy}
        </Text>
      )}
    </View>
  );
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return (
        <View style={s.user}>
          <Text style={s.userText}>{item.text}</Text>
        </View>
      );
    case 'assistant':
      return (
        <Text selectable style={s.assistant}>
          {item.text}
          {item.streaming ? '▍' : ''}
        </Text>
      );
    case 'tool':
      return (
        <View style={s.tool}>
          <Text style={s.toolSummary}>
            {item.summary} {item.result ? (item.result.ok ? '✓' : '✗') : '…'}
          </Text>
          {item.result && (
            <Text numberOfLines={6} style={s.toolPreview}>
              {item.result.preview}
            </Text>
          )}
        </View>
      );
    case 'truncation':
      return <Text style={s.truncation}>… {item.droppedEvents} earlier events dropped from the log</Text>;
    case 'error':
      return <Text style={s.error}>{item.message}</Text>;
  }
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8 },
  agentButton: { minHeight: TAP_MIN, justifyContent: 'center', paddingRight: 4, flexShrink: 1 },
  agentName: { color: C.text, fontWeight: '700', fontSize: 16 },
  badge: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '600' },

  banner: { backgroundColor: '#3a1f1e', borderColor: C.danger, borderWidth: 1, borderRadius: 10, margin: 12, padding: 10, gap: 4 },
  bannerTitle: { color: C.text, fontWeight: '700' },
  bannerText: { color: C.dim, fontSize: 13 },
  bannerCode: { color: C.text, fontFamily: 'monospace', fontSize: 13 },

  list: { flex: 1, paddingHorizontal: 12 },
  empty: { color: C.dim, textAlign: 'center', marginTop: 40 },
  user: { backgroundColor: C.surfaceAlt, borderRadius: 12, padding: 10, marginVertical: 5, alignSelf: 'flex-end', maxWidth: '90%' },
  userText: { color: C.text, fontSize: 15 },
  assistant: { color: C.text, fontSize: 15, marginVertical: 5, lineHeight: 21 },
  tool: { backgroundColor: C.surface, borderRadius: 10, padding: 10, marginVertical: 5, borderWidth: 1, borderColor: C.border },
  toolSummary: { color: C.accent, fontSize: 13, fontWeight: '600' },
  toolPreview: { color: C.dim, fontFamily: 'monospace', fontSize: 12, marginTop: 6 },
  truncation: { color: C.dim, fontStyle: 'italic', marginVertical: 6 },
  error: { color: C.danger, marginVertical: 6 },

  composer: { paddingHorizontal: 12, paddingTop: 8, gap: 8, borderTopWidth: 1, borderTopColor: C.border },
  composerRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  input: {
    flex: 1,
    minHeight: TAP_MIN,
    maxHeight: 140,
    backgroundColor: C.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    color: C.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  send: { minHeight: TAP_MIN, minWidth: 72, borderRadius: 12, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  mic: {
    minHeight: TAP_MIN,
    minWidth: TAP_MIN,
    borderRadius: 12,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micLive: { backgroundColor: C.danger, borderColor: C.danger },
  micText: { fontSize: 20, color: C.text },
  partial: { color: C.dim, fontStyle: 'italic', fontSize: 14 },
  voiceError: { color: C.warn, fontSize: 13 },
  sendText: { color: '#fff', fontWeight: '700' },
  modes: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mode: {
    minHeight: TAP_MIN,
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
  },
  modeActive: { borderColor: C.accent, backgroundColor: C.surfaceAlt },
  modeName: { color: C.dim, fontWeight: '700', fontSize: 14 },
  modeNameActive: { color: C.accent },
  modeBlurb: { color: C.dim, fontSize: 11 },
  primary: { minHeight: TAP_MIN + 6, borderRadius: 12, backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  disabled: { backgroundColor: C.surfaceAlt },
  stop: { minHeight: TAP_MIN, borderRadius: 12, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  stopText: { color: C.dim },
});
