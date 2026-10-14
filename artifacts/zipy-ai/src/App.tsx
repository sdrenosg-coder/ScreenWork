import { useEffect } from "react";
import { Router, Route, Switch, useLocation } from "wouter";
import RootLayout from "./app/layout";
import Dashboard from "./app/dashboard/page";
import Admin from "./app/admin/page";
import Analytics from "./app/analytics/page";
import Branding from "./app/settings/branding/page";
import GuideEdit from "./app/guides/[id]/edit/page";
import WorkflowReview from "./app/workflows/[id]/review/page";
import PublicGuide from "./app/p/[slug]/page";
import { ErrorBoundary } from "./components/error-boundary";

function Pages() {
  const [location] = useLocation();
  useEffect(() => {
    const title = location.startsWith("/dashboard") || location === "/" ? "Dashboard"
      : location.startsWith("/admin") ? "Administration"
      : location.startsWith("/analytics") ? "Analytics"
      : location.startsWith("/settings/branding") ? "Branding"
      : location.includes("/edit") ? "Guide editor"
      : location.includes("/review") ? "Workflow review" : "Guide";
    document.title = `${title} · Zipy AI`;
  }, [location]);
  return (
    <RootLayout>
      <ErrorBoundary resetKey={location}>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/dashboard" component={Dashboard} />
          <Route path="/admin" component={Admin} />
          <Route path="/analytics" component={Analytics} />
          <Route path="/settings/branding" component={Branding} />
          <Route path="/guides/:id/edit">{params => <GuideEdit params={params} />}</Route>
          <Route path="/workflows/:id/review">{params => <WorkflowReview params={params} />}</Route>
          <Route path="/p/:slug">{params => <PublicGuide params={params} />}</Route>
          <Route>
            <h1>Page not found</h1>
            <p>This page was not included in the imported app.</p>
            <a href={import.meta.env.BASE_URL + "dashboard"}>Return to dashboard</a>
          </Route>
        </Switch>
      </ErrorBoundary>
    </RootLayout>
  );
}

export default function App() {
  return <Router base={import.meta.env.BASE_URL.replace(/\/$/, "")}><Pages /></Router>;
}
