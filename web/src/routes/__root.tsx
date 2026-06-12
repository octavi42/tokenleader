import { createRootRoute, Outlet } from "@tanstack/react-router";
import { ThemeHotkey } from "../components/ThemeToggle";

export const Route = createRootRoute({
  component: () => (
    <>
      <ThemeHotkey />
      <Outlet />
    </>
  ),
});
