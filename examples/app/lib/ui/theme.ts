import { SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_STORAGE_KEY } from "@/lib/ui/sidebar-width";

export const THEME_STORAGE_KEY = "theme";

/**
 * Runs in <head> before first paint: applies the stored dark mode and sidebar width so neither flashes.
 * Storage can throw (private mode, blocked site data); then the page stays light at the default width.
 */
export const PREPAINT_SCRIPT = `try{var d=document.documentElement,s=localStorage;if(s.getItem(${JSON.stringify(THEME_STORAGE_KEY)})==="dark")d.classList.add("dark");var w=Number(s.getItem(${JSON.stringify(SIDEBAR_STORAGE_KEY)}));if(w>=${SIDEBAR_MIN}&&w<=${SIDEBAR_MAX})d.style.setProperty("--sidebar-w",Math.round(w)+"px")}catch(e){}`;
