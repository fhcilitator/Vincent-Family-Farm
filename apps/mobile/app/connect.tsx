import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useConnection } from '../src/connection';
import { forgetAgent, loadAgent, saveAgent } from '../src/agent-store';
import { C, TAP_MIN } from '../src/theme';

/**
 * Manual pairing.
 *
 * Phase 7 replaces this with a QR scan carrying both endpoints and a device
 * keypair. Until then this is the honest minimum: type what `vibe-agent init`
 * printed. It is deliberately a full screen rather than a settings row —
 * getting the trusted URL right is what keeps you off the restricted tier.
 */
export default function ConnectScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const connect = useConnection((s) => s.connect);
  const disconnect = useConnection((s) => s.disconnect);

  const [name, setName] = useState('dev box');
  const [trustedUrl, setTrustedUrl] = useState('');
  const [publicUrl, setPublicUrl] = useState('');
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    void loadAgent().then((saved) => {
      if (!saved) return;
      setName(saved.config.name);
      setTrustedUrl(saved.config.trustedUrl ?? '');
      setPublicUrl(saved.config.publicUrl ?? '');
      setToken(saved.token);
    });
  }, []);

  const save = async () => {
    const config = {
      name: name.trim() || 'dev box',
      trustedUrl: trustedUrl.trim() || null,
      publicUrl: publicUrl.trim() || null,
    };
    if (!config.trustedUrl && !config.publicUrl) {
      setProblem('Enter at least one address.');
      return;
    }
    if (!token.trim()) {
      setProblem('The agent token is required — it is the only thing protecting the dev box.');
      return;
    }
    await saveAgent(config, token.trim());
    connect(config, token.trim());
    router.back();
  };

  const forget = async () => {
    disconnect();
    await forgetAgent();
    setTrustedUrl('');
    setPublicUrl('');
    setToken('');
  };

  return (
    <ScrollView
      style={s.root}
      contentContainerStyle={{ padding: 16, paddingTop: insets.top + 16, paddingBottom: insets.bottom + 24, gap: 6 }}
    >
      <Text style={s.h1}>Agent</Text>

      <Field label="Name" value={name} onChange={setName} placeholder="dev box" />

      <Field
        label="Tailnet address (trusted)"
        value={trustedUrl}
        onChange={setTrustedUrl}
        placeholder="wss://devbox.tail1234.ts.net"
      />
      <Text style={s.help}>
        Tried first. On this path Claude can remember an approval for the rest of the session.
      </Text>

      <Field
        label="Public address (restricted)"
        value={publicUrl}
        onChange={setPublicUrl}
        placeholder="wss://agent.example.com"
      />
      <Text style={s.help}>
        The fallback. An approval cannot be remembered for the rest of the session here, and prompts
        expire after two minutes — a prompt you are not there to answer should fail closed sooner.
        Auto mode is available if you would rather it run without asking.
      </Text>

      <Field label="Agent token" value={token} onChange={setToken} placeholder="from vibe-agent init" secure />
      <Text style={s.help}>
        Stored in the Android keystore. This is not an Anthropic credential — the app never has one.
        Claude is authenticated on the dev box.
      </Text>

      {problem && <Text style={s.problem}>{problem}</Text>}

      <Pressable style={s.primary} onPress={() => void save()}>
        <Text style={s.primaryText}>Save and connect</Text>
      </Pressable>
      <Pressable style={s.secondary} onPress={() => void forget()}>
        <Text style={s.secondaryText}>Forget this agent</Text>
      </Pressable>
    </ScrollView>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secure,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  secure?: boolean;
}) {
  return (
    <View style={{ marginTop: 10 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={C.dim}
        secureTextEntry={secure}
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        inputMode="url"
      />
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  h1: { color: C.text, fontSize: 24, fontWeight: '700', marginBottom: 8 },
  label: { color: C.dim, fontSize: 13, marginBottom: 4 },
  input: {
    minHeight: TAP_MIN,
    backgroundColor: C.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    color: C.text,
    paddingHorizontal: 12,
    fontSize: 15,
  },
  help: { color: C.dim, fontSize: 12, marginTop: 6, lineHeight: 17 },
  problem: { color: C.danger, marginTop: 12 },
  primary: {
    marginTop: 20,
    minHeight: TAP_MIN + 6,
    borderRadius: 12,
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondary: {
    marginTop: 10,
    minHeight: TAP_MIN,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryText: { color: C.dim },
});
