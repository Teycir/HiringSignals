import { redirect } from "next/navigation";

// Root "/" redirects immediately to the signal feed. There is no content
// here -- /signals is the primary entry point (spec 10.2). Using a server-
// side redirect (not a client <Link>) so users, crawlers, and the Cloudflare
// Pages edge see a 307 rather than a blank page with a text link.
export default function Home() {
  redirect("/signals");
}
