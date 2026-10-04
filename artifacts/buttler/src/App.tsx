import { Switch, Route, Router as WouterRouter } from "wouter";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/auth/AuthProvider";
import Home from "@/pages/Home";
import Contribute from "@/pages/Contribute";
import MyContributions from "@/pages/MyContributions";
import Moderation from "@/pages/Moderation";
import Promotions from "@/pages/Promotions";
import NotFound from "@/pages/not-found";
import { InstallBanner } from "@/components/InstallBanner";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      {/* Stage 13 contribution workflow. The pages gate on sign-in STATE and
          let the server decide permissions — see src/contributions/*. */}
      <Route path="/contribute" component={Contribute} />
      <Route path="/my-contributions" component={MyContributions} />
      <Route path="/moderation" component={Moderation} />
      {/* Stage 14 promotion console. Like /moderation it gates on sign-in STATE
          and lets the server enforce the separate promoter allow-list. */}
      <Route path="/promotions" component={Promotions} />
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
