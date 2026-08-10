import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PendingPermission } from '@vff/client-core';
import { C, TAP_MIN } from '../theme';

/**
 * The approval sheet.
 *
 * Two rules it exists to enforce:
 *
 *  - **Show the literal thing being approved**, never a paraphrase. If Claude
 *    is about to run `rm -rf build`, that string appears on screen character
 *    for character. A summary is how people approve something they would have
 *    refused.
 *  - **Approval is a deliberate tap.** Large targets, Deny on the left where a
 *    right thumb is less likely to land, and no gesture or voice path to
 *    "allow" — the permission gate is only worth having if it is a considered
 *    act.
 */
export function PermissionSheet({
  ask,
  onDecide,
}: {
  ask: PendingPermission | null;
  onDecide: (requestId: string, allow: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  if (!ask) return null;

  const risky = ask.render.risk === 'high';

  return (
    <Modal transparent animationType="slide" visible onRequestClose={() => onDecide(ask.requestId, false)}>
      <View style={s.scrim}>
        <View style={[s.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <View style={s.head}>
            <Text style={s.title}>{ask.render.title}</Text>
            <Text style={[s.risk, { color: risky ? C.danger : C.warn }]}>
              {ask.render.risk} risk
            </Text>
          </View>
          <Text style={s.subtitle}>{ask.render.subtitle}</Text>

          <ScrollView style={s.bodyBox} contentContainerStyle={{ padding: 12 }}>
            <Text selectable style={s.body}>
              {ask.render.body.value}
            </Text>
          </ScrollView>

          <View style={s.actions}>
            <Pressable
              accessibilityRole="button"
              style={[s.button, s.deny]}
              onPress={() => onDecide(ask.requestId, false)}
            >
              <Text style={s.buttonText}>Deny</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={[s.button, risky ? s.allowRisky : s.allow]}
              onPress={() => onDecide(ask.requestId, true)}
            >
              <Text style={s.buttonText}>Allow once</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: '#000a', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: C.surface,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 16,
    gap: 8,
    maxHeight: '80%',
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: C.text, fontSize: 18, fontWeight: '700', flexShrink: 1 },
  risk: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase' },
  subtitle: { color: C.dim, fontSize: 13 },
  bodyBox: {
    backgroundColor: C.bg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: C.border,
    maxHeight: 260,
  },
  body: { color: C.text, fontFamily: 'monospace', fontSize: 14 },
  actions: { flexDirection: 'row', gap: 12, marginTop: 8 },
  button: {
    flex: 1,
    minHeight: TAP_MIN + 8,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deny: { backgroundColor: C.surfaceAlt, borderWidth: 1, borderColor: C.border },
  allow: { backgroundColor: C.accent },
  allowRisky: { backgroundColor: C.danger },
  buttonText: { color: C.text, fontSize: 16, fontWeight: '700' },
});
