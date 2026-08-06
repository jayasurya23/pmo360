import { lazy } from "react";
import { Link, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";

// Pages are code-split (one chunk each) so the initial load only pulls Home +
// shared vendor — heavy deps (pdfjs, matplotlib-free Gantt, dnd-kit, recharts)
// load on demand when their route is first visited. Suspense lives in Layout,
// around <Outlet/>, so the nav shell stays put while a page chunk streams in.
const Home = lazy(() => import("./pages/Home"));
const PortfolioDashboard = lazy(() => import("./pages/PortfolioDashboard"));
const Capture = lazy(() => import("./pages/Capture"));
const Review = lazy(() => import("./pages/Review"));
const Preview = lazy(() => import("./pages/Preview"));
const Send = lazy(() => import("./pages/Send"));
const NextAgenda = lazy(() => import("./pages/NextAgenda"));
const Actions = lazy(() => import("./pages/Actions"));
const Notes = lazy(() => import("./pages/Notes"));
const History = lazy(() => import("./pages/History"));
const Schedule = lazy(() => import("./pages/Schedule"));
const Settings = lazy(() => import("./pages/Settings"));
const LeadDashboard = lazy(() => import("./pages/LeadDashboard"));
const Timeline = lazy(() => import("./pages/Timeline"));
const Proposals = lazy(() => import("./pages/Proposals"));
const ChangeOrders = lazy(() => import("./pages/ChangeOrders"));

/**
 * Anything that matches no route above.
 *
 * React Router renders NOTHING for an unmatched path unless you ask it to, so
 * before this the app answered a typo, a stale bookmark or an email client that
 * clipped a link with a blank page — no message, and no nav to leave by. That
 * became load-bearing the moment change-order approval requests started mailing
 * people a URL: the one person most likely to mistype it is the one being asked
 * to approve money, and a white screen tells them the app is broken.
 *
 * Deliberately NOT lazy and deliberately inside <Layout>: the shell stays, so
 * the way out is on screen, and the fallback for "nothing loaded" must not
 * itself be a chunk that can fail to load.
 */
function NotFound() {
  return (
    <div className="card p-8 text-center">
      <div className="label">404</div>
      <h1 className="page-title mb-2">Page not found</h1>
      <p className="text-sm text-brand-gray mb-6">
        That address doesn't match anything in PMO 360. If you followed a link
        from an email, it may have been cut short — check that you copied the
        whole thing.
      </p>
      <Link to="/" className="btn-primary">
        Back to Home
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="/portfolio" element={<PortfolioDashboard />} />
        <Route path="/capture" element={<Capture />} />
        <Route path="/review" element={<Review />} />
        <Route path="/preview" element={<Preview />} />
        <Route path="/send" element={<Send />} />
        <Route path="/next-agenda" element={<NextAgenda />} />
        <Route path="/actions" element={<Actions />} />
        <Route path="/notes" element={<Notes />} />
        <Route path="/history" element={<History />} />
        <Route path="/schedule" element={<Schedule />} />
        <Route path="/timeline" element={<Timeline />} />
        <Route path="/proposals" element={<Proposals />} />
        <Route path="/change-orders" element={<ChangeOrders />} />
        {/* Where an approval-request email lands. Same page, told which change
            order to open — it selects the CO's client + portfolio, switches to
            the tab holding it and highlights it.

            The only parameterised route in the app. It cannot shadow the bare
            /change-orders above and does not depend on being declared after it:
            React Router v6 ranks by specificity, not source order, and these two
            differ by a whole segment. Order here is for the reader. */}
        <Route path="/change-orders/:coId" element={<ChangeOrders />} />
        <Route path="/lead" element={<LeadDashboard />} />
        <Route path="/settings" element={<Settings />} />
        {/* Last, and inside Layout on purpose — see NotFound. */}
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
