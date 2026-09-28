import { Tabs, TabsTrigger, TabsList } from "@/components/ui/tabs";
import { useState } from "react";
import SessionDetails from "./session-details";
import SessionLogs from "./session-logs";
import SessionDevTools from "./session-devtools";

interface SessionConsoleProps {
  id: string | null;
}

export default function SessionConsole({ id }: SessionConsoleProps) {
  const [activeTab, setActiveTab] = useState<
    "details" | "console" | "network" | "dev-tools"
  >("details");

  const tabs: {
    value: "details" | "console" | "network" | "dev-tools";
    label: string;
  }[] = [
    { value: "details", label: "Details" },
    { value: "console", label: "Console" },
    { value: "network", label: "Network" },
    { value: "dev-tools", label: "Dev Tools" },
  ];

  return (
    <div className="flex flex-col w-full h-full min-h-0">
      <div className="flex flex-row items-center bg-[var(--gray-3)] px-2 border-b border-[var(--gray-6)] shrink-0">
        <Tabs defaultValue="details">
          <TabsList className="bg-transparent h-10">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                onClick={() => setActiveTab(tab.value)}
                className={`!bg-transparent !shadow-none rounded-none px-3 h-10 text-xs ${
                  activeTab === tab.value
                    ? "border-b-2 border-b-[var(--gray-12)] text-[var(--gray-12)]"
                    : "text-[var(--gray-10)]"
                }`}
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "details" && <SessionDetails id={id} />}
        {activeTab === "console" && id && (
          <SessionLogs id={id} filter="console" />
        )}
        {activeTab === "network" && id && (
          <SessionLogs id={id} filter="network" />
        )}
        {activeTab === "dev-tools" && <SessionDevTools />}
      </div>
    </div>
  );
}
