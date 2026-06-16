import { Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import PortfolioDashboard from "./pages/PortfolioDashboard";
import Capture from "./pages/Capture";
import Review from "./pages/Review";
import Preview from "./pages/Preview";
import Send from "./pages/Send";
import NextAgenda from "./pages/NextAgenda";
import Actions from "./pages/Actions";
import Notes from "./pages/Notes";
import History from "./pages/History";
import Schedule from "./pages/Schedule";
import Settings from "./pages/Settings";
import LeadDashboard from "./pages/LeadDashboard";
import Timeline from "./pages/Timeline";
import Proposals from "./pages/Proposals";

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
