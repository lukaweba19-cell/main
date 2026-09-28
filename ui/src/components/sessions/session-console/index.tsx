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
    <div className="flex flex-col w-full">
      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
        <div className="flex flex-row items-center px-3 border-b border-[var(--gray-6)] shrink-0">
          <TabsList className="bg-transparent h-11 gap-1 p-0 rounded-none">
            {tabs.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className={`!bg-transparent !shadow-none rounded-none px-3 h-11 text-sm transition-colors border-b-2 ${
                  activeTab === tab.value
                    ? "border-b-[var(--gray-12)] text-[var(--gray-12)]"
                    : "border-b-transparent text-[var(--gray-10)] hover:text-[var(--gray-11)]"
                }`}
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>

      <div className="w-full overflow-hidden">
        {activeTab === "details" && <SessionDetails id={id} />}
        {activeTab === "console" && id && (
          <div className="h-[420px] overflow-hidden">
            <SessionLogs id={id} filter="console" />
          </div>
        )}
        {activeTab === "network" && id && (
          <div className="h-[420px] overflow-hidden">
            <SessionLogs id={id} filter="network" />
          </div>
        )}
        {activeTab === "dev-tools" && (
          <div className="h-[560px] overflow-hidden">
            <SessionDevTools />
          </div>
        )}
      </div>
    </div>
  );
}
