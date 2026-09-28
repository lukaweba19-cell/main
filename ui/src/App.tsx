import "@fontsource/inter";
import "@radix-ui/themes/styles.css";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import RootLayout from "@/root-layout";
import { client } from "@/steel-client";
import { env } from "@/env";
import { SessionContainer } from "@/containers/session-container";
import { SessionsDashboard } from "@/components/sessions/sessions-dashboard";

client.setConfig({
  baseUrl: env.VITE_API_URL,
});

function App() {
  return (
    <BrowserRouter basename="/ui">
      <Routes>
        <Route element={<RootLayout />}>
          <Route index element={<Navigate to="/sessions" replace />} />
          <Route path="sessions" element={<SessionsDashboard />} />
          <Route path="sessions/:id" element={<SessionContainer />} />
          <Route path="*" element={<Navigate to="/sessions" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
