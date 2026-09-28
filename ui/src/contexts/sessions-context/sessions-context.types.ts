import {
  GetSessionDetailsError,
  GetSessionDetailsResponse,
  ReleaseBrowserSessionResponse,
  ReleaseBrowserSessionsError,
  SessionDetails,
} from "@/steel-client";
import { ReactNode } from "react";
import { UseMutationResult, UseQueryResult } from "@tanstack/react-query";

export type SessionsListResponse = {
  sessions: SessionDetails[];
};

export type SessionsContextType = {
  useReleaseSessionMutation: () => UseMutationResult<
    ReleaseBrowserSessionResponse,
    ReleaseBrowserSessionsError,
    string,
    unknown
  >;
  useSession: (
    id: string
  ) => UseQueryResult<GetSessionDetailsResponse | null, GetSessionDetailsError>;
  useSessions: () => UseQueryResult<SessionsListResponse, Error>;
};

export type SessionsProviderProps = {
  children: ReactNode;
};
