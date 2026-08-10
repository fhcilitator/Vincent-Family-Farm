import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {/*
        Android 16 (API 36) enforces edge-to-edge with no opt-out, so nothing
        may rely on the system bars reserving space. Screens use
        `useSafeAreaInsets` for their own padding.
      */}
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="connect" options={{ presentation: 'modal' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
