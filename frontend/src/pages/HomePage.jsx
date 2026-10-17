import React from "react";
import { Link } from "react-router-dom";
import {
  Code2,
  ClipboardCheck,
  Briefcase,
  Video,
  ShieldCheck,
  BookOpen,
  ArrowRight,
} from "lucide-react";

// Public landing page for the base URL. Everything here is static; it only reads the
// stored user to decide which call-to-action buttons to show.
const FEATURES = [
  {
    icon: ClipboardCheck,
    title: "Timed coding assessments",
    text: "Schedule assessments with coding, multiple-choice and written questions. Code answers are run and graded automatically against hidden test cases.",
  },
  {
    icon: Briefcase,
    title: "Placement drives",
    text: "Run a whole recruitment drive in one place: shortlist candidates, move them through rounds, and keep the pipeline in view.",
  },
  {
    icon: Video,
    title: "Live interview rooms",
    text: "Interview candidates in a shared room with a collaborative code editor and video, with no extra tools to install.",
  },
  {
    icon: ShieldCheck,
    title: "Built for exam day",
    text: "Per-student submission limits, anti-cheating signals and a monitoring dashboard keep large cohorts fair and the system steady.",
  },
];

const getStoredUser = () => {
  try {
    return JSON.parse(localStorage.getItem("user"));
  } catch {
    return null;
  }
};

const HomePage = () => {
  const user = getStoredUser();

  return (
    <div className="container fade-in" style={{ paddingTop: "56px", paddingBottom: "72px" }}>
      <section style={{ textAlign: "center", maxWidth: "760px", margin: "0 auto 64px" }}>
        <div
          style={{
            display: "inline-flex",
            padding: "16px",
            background: "rgba(99, 102, 241, 0.1)",
            borderRadius: "50%",
            marginBottom: "24px",
          }}
        >
          <Code2 size={36} color="var(--primary)" />
        </div>
        <h1 style={{ fontSize: "2.6rem", lineHeight: 1.15, marginBottom: "16px" }}>
          Assess, shortlist and interview, all in one place
        </h1>
        <p className="text-muted" style={{ fontSize: "1.1rem", marginBottom: "32px" }}>
          A placement platform for colleges: timed coding assessments with automatic grading,
          recruitment drives, and live interviews.
        </p>
        <div style={{ display: "flex", gap: "12px", justifyContent: "center", flexWrap: "wrap" }}>
          {user ? (
            <>
              <Link to="/assessments" className="button button-primary">
                Go to assessments <ArrowRight size={16} />
              </Link>
              <Link to="/problems" className="button button-outline">
                Practice problems
              </Link>
            </>
          ) : (
            <>
              <Link to="/login" className="button button-primary">
                Log in <ArrowRight size={16} />
              </Link>
              <Link to="/signup" className="button button-outline">
                Register your college
              </Link>
              <Link to="/problems" className="button button-outline">
                <BookOpen size={16} /> Browse problems
              </Link>
            </>
          )}
        </div>
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "20px",
        }}
      >
        {FEATURES.map(({ icon, title, text }) => {
          const Icon = icon;
          return (
          <div key={title} className="problem-card" style={{ padding: "28px", cursor: "default" }}>
            <Icon size={26} color="var(--primary)" style={{ marginBottom: "14px" }} />
            <h3 style={{ marginBottom: "8px" }}>{title}</h3>
            <p className="text-muted" style={{ fontSize: "0.92rem", margin: 0 }}>
              {text}
            </p>
          </div>
          );
        })}
      </section>
    </div>
  );
};

export default HomePage;
