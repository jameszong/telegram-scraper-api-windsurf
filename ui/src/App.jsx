import React, { useEffect } from "react";
import { useAuthStore } from "./store/authStore";
import { LoginPage } from "./components/LoginPage";
import { Dashboard } from "./components/Dashboard";
import AccessGatekeeper from "./components/AccessGatekeeper";
import "./index.css";

function App() {
  const { isLoggedIn, sessionString } = useAuthStore();

  return (
    <AccessGatekeeper>
      <div className="min-h-screen bg-background">
        {isLoggedIn ? <Dashboard /> : <LoginPage />}
      </div>
    </AccessGatekeeper>
  );
}

export default App;
