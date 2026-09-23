/**
 * Buttler 2.0 — Stage 13 frontend: the auth provider.
 *
 * Deliberately small: it owns ONE piece of state (the sign-in status), runs the
 * redirect handling once on startup, and hands the rest of the app an
 * `authorizedFetch`. It never decides what a signed-in user may do.
 *
 * Startup order, and why it is in this order:
 *   1. Read the public configuration. Absent -> `unconfigured`, and the Auth0
 *      SDK is never loaded. Production visitors today get exactly the UI they
 *      got before this feature existed.
 *   2. If the URL still carries Auth0's `?code`, exchange it before anything
 *      else asks about the session, then strip it so a refresh cannot replay a
 *      spent code.
 *   3. Otherwise try a silent renewal.
 *   4. Report authenticated / anonymous.
 * Any throw inside that sequence lands in the `error` state. Nothing here is
 * allowed to reject into the React tree: the map, search, and catalogue stay
 * usable whatever Auth0 does.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import {
  callbackUrlFor,
  describeAuthError,
  hasRedirectResult,
  readAuth0Config,
  withoutRedirectParams,
} from "@/auth/config";
import { createButtlerAuthClient, type ButtlerAuthClient } from "@/auth/auth0-client";
import {
  initialAuthState,
  profileFromClaims,
  reduceAuthState,
  type AuthEvent,
  type AuthState,
} from "@/auth/state";
import {
  createAuthorizedFetch,
  type AuthorizedFetch,
} from "@/auth/authorized-fetch";

export interface ButtlerAuth {
  state: AuthState;
  /** Sign in through Auth0's Universal Login (Authorization Code + PKCE). */
  login: () => Promise<void>;
  /** Clear the local session and return to the app root. */
  logout: () => Promise<void>;
  /** Re-run startup after a provider error, without reloading the page. */
  retry: () => Promise<void>;
  /** `fetch` that attaches Buttler's bearer token to Buttler's own API only. */
  authorizedFetch: AuthorizedFetch;
}

const basePath = (import.meta.env.BASE_URL ?? "/").replace(/\/+$/, "");
const appOrigin =
  typeof window !== "undefined" ? window.location.origin : "http://localhost";
const appRootUrl = `${appOrigin}${basePath}/`;

const AuthContext = createContext<ButtlerAuth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reduceAuthState, undefined, initialAuthState);
  const clientRef = useRef<ButtlerAuthClient | null>(null);
  const startedRef = useRef(false);

  const start = useCallback(async () => {
    const config = readAuth0Config(import.meta.env);
    if (config.status === "missing") {
      // Not an error. No public Auth0 configuration means no sign-in is offered,
      // which is exactly Buttler's current production behaviour.
      dispatch({ type: "unconfigured" });
      return;
    }

    try {
      const client = await createButtlerAuthClient(config.config, appRootUrl);
      clientRef.current = client;

      if (hasRedirectResult(window.location.search)) {
        try {
          await client.completeRedirectCallback();
        } catch (cause) {
          dispatch({ type: "error", message: describeAuthError(cause) });
          return;
        } finally {
          // Drop the one-time parameters on success and failure alike, so a
          // refresh cannot replay a spent code.
          window.history.replaceState(
            {},
            "",
            withoutRedirectParams(window.location.href),
          );
        }
      } else {
        await client.restoreSession();
      }

      if (!(await client.isAuthenticated())) {
        dispatch({ type: "signed-out" });
        return;
      }
      dispatch({
        type: "signed-in",
        profile: profileFromClaims(await client.getUser()),
      });
    } catch (cause) {
      dispatch({ type: "error", message: describeAuthError(cause) });
    }
  }, []);

  useEffect(() => {
    // Guarded rather than cleanup-based: handling the redirect callback twice
    // (React StrictMode, or a remount) would replay a one-time authorization
    // code and turn a successful sign-in into an error.
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [start]);

  const login = useCallback(async () => {
    const config = readAuth0Config(import.meta.env);
    if (config.status === "missing") {
      dispatch({
        type: "error",
        message: "sign-in is not configured for this deployment",
      });
      return;
    }
    try {
      const client =
        clientRef.current ??
        (await createButtlerAuthClient(config.config, appRootUrl));
      clientRef.current = client;
      dispatch({ type: "loading" });
      await client.login(appRootUrl);
    } catch (cause) {
      dispatch({ type: "error", message: describeAuthError(cause) });
    }
  }, []);

  const logout = useCallback(async () => {
    const client = clientRef.current;
    // Clear what the UI can show before the provider redirect happens, so the
    // identity is gone even if that redirect is slow or blocked.
    dispatch({ type: "signed-out" });
    if (!client) return;
    try {
      await client.logout(appRootUrl);
    } catch (cause) {
      dispatch({ type: "error", message: describeAuthError(cause) });
    }
  }, []);

  const authorizedFetch = useMemo(
    () =>
      createAuthorizedFetch({
        origin: appOrigin,
        getToken: async () => {
          const client = clientRef.current;
          return client ? await client.getAccessToken() : null;
        },
      }),
    [],
  );

  const value = useMemo<ButtlerAuth>(
    () => ({ state, login, logout, retry: start, authorizedFetch }),
    [state, login, logout, start, authorizedFetch],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * The auth surface for the app. Outside a provider it reports `unconfigured`
 * rather than throwing, so a component that forgot the provider can never take
 * the catalogue down with it.
 */
export function useButtlerAuth(): ButtlerAuth {
  return useContext(AuthContext) ?? FALLBACK_AUTH;
}

const FALLBACK_AUTH: ButtlerAuth = {
  state: { status: "unconfigured", profile: null, error: null },
  login: async () => {},
  logout: async () => {},
  retry: async () => {},
  authorizedFetch: createAuthorizedFetch({
    origin: appOrigin,
    getToken: async () => null,
  }),
};
