import { createContext } from "react";
import {
  SessionsContextType,
  SessionsProviderProps,
  SessionsListResponse,
} from "./sessions-context.types";
import {
  getSessions,
  getSessionDetails,
  releaseBrowserSession,
  ReleaseBrowserSessionResponse,
  ReleaseBrowserSessionsError,
  SessionDetails,
} from "@/steel-client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/query-client";
import { ErrorResponse } from "@remix-run/router";

// eslint-disable-next-line react-refresh/only-export-components
export const SessionsContext = createContext<SessionsContextType | undefined>(
  undefined,
);

export function SessionsProvider({
  children,
}: SessionsProviderProps): JSX.Element {
  const useSessions = () =>
    useQuery<SessionsListResponse, Error>({
      queryKey: ["sessions"],
      queryFn: async () => {
        const { error, data } = await getSessions();
        if (error || !data) {
          throw error || new Error("Failed to load sessions");
        }
        return data as SessionsListResponse;
      },
      refetchInterval: 2000,
      retry: false,
    });

  const useSession = (id: string) =>
    useQuery<SessionDetails, ErrorResponse>({
      queryKey: ["session", id],
      queryFn: async () => {
        if (!id) {
          const { error, data } = await getSessions();
          if (error || !data) {
            throw error;
          }
          return data?.sessions?.[0];
        }
        const { error, data } = await getSessionDetails({
          path: {
            sessionId: id,
          },
        });
        if (error || !data) {
          throw error;
        }
        return data;
      },
      enabled: true,
      retry: false,
      refetchInterval: 1000,
    });

  const useReleaseSessionMutation = () =>
    useMutation<
      ReleaseBrowserSessionResponse,
      ReleaseBrowserSessionsError,
      string
    >({
      //@ts-expect-error Mutation function is not defined
      mutationFn: async (id: string) => {
        const { error, data } = await releaseBrowserSession({
          path: {
            sessionId: id,
          },
        });
        if (error) {
          throw error;
        }
        queryClient.refetchQueries({ queryKey: ["session", id] });
        queryClient.invalidateQueries({ queryKey: ["sessions"] });
        queryClient.invalidateQueries({ queryKey: ["sessionLogs", id] });
        return data;
      },
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["sessions"] });
      },
    });

  return (
    <SessionsContext.Provider
      value={{
        useReleaseSessionMutation,
        useSession,
        useSessions,
      }}
    >
      {children}
    </SessionsContext.Provider>
  );
}
