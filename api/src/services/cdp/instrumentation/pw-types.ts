/**
 * Local patchright-compatible type aliases. The `patchright` package does not
 * publicly export Target/TargetType/Protocol, so the small surface used by the
 * instrumentation layer is declared here.
 */
export enum TargetType {
  PAGE = "page",
  BACKGROUND_PAGE = "background_page",
  SERVICE_WORKER = "service_worker",
  SHARED_WORKER = "shared_worker",
  OTHER = "other",
  BROWSER = "browser",
  WEBVIEW = "webview",
  IFRAME = "iframe",
}

export interface Target {
  url(): string;
  type(): TargetType | string;
  page(): Promise<import("patchright").Page | null>;
  createCDPSession(): Promise<import("patchright").CDPSession>;
  asPage(): Promise<import("patchright").Page | null>;
}

// Chrome DevTools Protocol payloads. The instrumentation layer only serializes
// these into log storage, so every message shape is intentionally loose.
export namespace Protocol {
  export namespace Runtime {
    export type RemoteObject = {
      type?: string;
      value?: any;
      description?: string;
      [key: string]: any;
    };
    export type StackTrace = {
      callFrames?: any[];
      [key: string]: any;
    };
    export type ConsoleAPICalledEvent = {
      type: string;
      args: RemoteObject[];
      stackTrace?: StackTrace;
      executionContextId?: number;
      [key: string]: any;
    };
    export type ExceptionThrownEvent = {
      exceptionDetails: {
        exception?: RemoteObject;
        text: string;
        url?: string;
        lineNumber?: number;
        columnNumber?: number;
        executionContextId?: number;
        [key: string]: any;
      };
    };
    export type BindingCalledEvent = {
      name: string;
      payload?: string;
      [key: string]: any;
    };
  }

  export interface RemoteObject {
    type?: string;
    value?: any;
    description?: string;
    [key: string]: any;
  }

  export interface CallFrame {
    url: string;
    lineNumber: number;
    columnNumber: number;
    [key: string]: any;
  }

  export interface StackTrace {
    callFrames?: CallFrame[];
    [key: string]: any;
  }

  export interface ConsoleAPICalledEvent {
    type: string;
    args: RemoteObject[];
    stackTrace?: StackTrace;
    executionContextId?: number;
    [key: string]: any;
  }

  export interface ExceptionThrownEvent {
    exceptionDetails: {
      exception?: RemoteObject;
      text: string;
      url?: string;
      lineNumber?: number;
      columnNumber?: number;
      executionContextId?: number;
      [key: string]: any;
    };
  }

  export interface BindingCalledEvent {
    name: string;
    payload?: string;
    [key: string]: any;
  }

  export namespace Network {
    export interface LoadingFailedEvent {
      requestId: string;
      errorText: string;
      type?: string;
      [key: string]: any;
    }

    export interface RequestWillBeSentEvent {
      requestId: string;
      request: { url: string; method: string; headers?: Record<string, string>; [key: string]: any };
      type?: string;
      frameId?: string;
      [key: string]: any;
    }

    export interface ResponseReceivedEvent {
      requestId: string;
      response: {
        status: number;
        url: string;
        mimeType?: string;
        headers?: Record<string, string>;
        [key: string]: any;
      };
      type?: string;
      [key: string]: any;
    }

    export interface LoadingFinishedEvent {
      requestId: string;
      encodedDataLength?: number;
      [key: string]: any;
    }

    export interface DataReceivedEvent {
      requestId: string;
      dataLength?: number;
      encodedDataLength?: number;
      [key: string]: any;
    }

    export interface RequestServedFromCacheEvent {
      requestId: string;
      [key: string]: any;
    }

    export interface RequestWillBeSentExtraInfoEvent {
      requestId: string;
      [key: string]: any;
    }

    export interface ResponseReceivedExtraInfoEvent {
      requestId: string;
      [key: string]: any;
    }
  }

  export interface EventPayload {
    [key: string]: any;
  }
}
