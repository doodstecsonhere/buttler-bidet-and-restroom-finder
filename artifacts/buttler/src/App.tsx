import { Switch, Route, Router as WouterRouter } from "wouter";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/auth/AuthProvider";
import Home from "@/pages/Home";
import NotFound from "@/pages/not-found";
import { InstallBanner } from "@/components/InstallBanner";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <TooltipProvider>
      {/* Auth is app-wide state but owns no layout: it adds a header control and
          an `authorizedFetch`, and stays inert without public Auth0 config. */}
      <AuthProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
        <InstallBanner />
      </AuthProvider>
    </TooltipProvider>
  );
}

export default App;
