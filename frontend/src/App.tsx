import { lazy } from "react";
import { Routes, Route } from "react-router-dom";
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
        <Route path="/lead" element={<LeadDashboard />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
