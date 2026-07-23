import { Box, Text, useApp, useInput } from "ink";
import { useState } from "react";
import { Banner, Footer, Menu } from "./components";
import { CapacityScreen } from "./screens/capacity";
import { DoctorScreen } from "./screens/doctor";
import { RunScreen } from "./screens/run";
import { RunsScreen } from "./screens/runs";
import { theme } from "./theme";

type Screen = "home" | "run" | "doctor" | "capacity" | "runs";

export interface AppProps {
  version: string;
  repoPath: string;
}

export function App({ version, repoPath }: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("home");

  // Global keys. The Run and Runs screens own escape while active.
  useInput((input, key) => {
    if (input === "q" && screen === "home") exit();
    else if ((key.escape || input === "q") && screen !== "home" && screen !== "run" && screen !== "runs") {
      setScreen("home");
    }
  });

  if (screen === "home") {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Banner version={version} />
        <Text color={theme.muted}>  {repoPath}</Text>
        <Box marginTop={1}>
          <Menu
            items={[
              { key: "run", label: "Run", hint: "single agent or team" },
              { key: "doctor", label: "Doctor", hint: "adapter health" },
              { key: "capacity", label: "Capacity", hint: "quota from AI-Quota-Tray" },
              { key: "runs", label: "Runs", hint: "history in this repo" },
              { key: "quit", label: "Quit" },
            ]}
            onSelect={(key) => {
              if (key === "quit") exit();
              else setScreen(key as Screen);
            }}
          />
        </Box>
        <Footer hints={["↑↓ move", "enter select", "q quit"]} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {screen === "run" ? (
        <RunScreen repoPath={repoPath} onExit={() => setScreen("home")} />
      ) : screen === "doctor" ? (
        <DoctorScreen />
      ) : screen === "capacity" ? (
        <CapacityScreen />
      ) : (
        <RunsScreen repoPath={repoPath} onBack={() => setScreen("home")} />
      )}
      {screen === "run" ? null : <Footer hints={["esc back", "q home"]} />}
    </Box>
  );
}
