import Link from "next/link";
import packageJson from "../../package.json";

// Ported from ArxivExplorer's app/components/Footer.tsx (same author's
// own code) and restyled to this repo's brutalist tokens (globals.css):
// solid ink border, paper bg, mono meta text -- no neon/glass. The
// web app has no icon dependency here, so the heart/book use
// typographic glyphs and the two share icons are inline SVGs copied
// verbatim from the ArxivExplorer source. /how-to-use and /faq are the
// ArxivExplorer-style info pages ported alongside this footer.

// Deploy target per apps/web/wrangler.jsonc; used for share URLs.
const SITE_URL = "https://hiring-signals-web.teycircoder14.workers.dev";
const REPO_URL = "https://github.com/Teycir/HiringSignals";
const APP_VERSION = packageJson.version;

export function Footer() {
  return (
    <footer className="border-t-2 border-ink bg-paper px-6 py-4">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 text-xs font-mono text-soft-ink sm:flex-row">
        <div className="flex flex-wrap items-center justify-center gap-2 text-center">
          <span>
            Built with <span aria-hidden="true">♥</span> and{" "}
            <span aria-hidden="true">📖</span> by{" "}
            <a
              href="https://teycirbensoltane.tn"
              target="_blank"
              rel="noopener noreferrer"
              className="underline transition-colors hover:text-ink"
            >
              Teycir Ben Soltane
            </a>
          </span>
          <span className="hidden sm:inline" aria-hidden="true">
            •
          </span>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Link href="/how-to-use" className="underline transition-colors hover:text-ink">
              How to Use
            </Link>
            <span aria-hidden="true">•</span>
            <Link href="/faq" className="underline transition-colors hover:text-ink">
              FAQ
            </Link>
            <span aria-hidden="true">•</span>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="underline transition-colors hover:text-ink"
            >
              GitHub
            </a>
            <span aria-hidden="true">•</span>
            <a
              href={`${REPO_URL}/releases/tag/v${APP_VERSION}`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline transition-colors hover:text-ink"
            >
              v{APP_VERSION}
            </a>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="leading-none">Share:</span>
          <a
            href={`https://twitter.com/intent/tweet?text=HIRING%2F%2FSIGNALS%20%E2%80%94%20Public%20hiring-signal%20feed%20derived%20from%20job-board%20postings.%20Not%20a%20candidate%20database.&url=${encodeURIComponent(SITE_URL)}&hashtags=hiring,jobs,Signals`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center p-2 transition-colors hover:text-ink"
            aria-label="Share on X/Twitter"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              fill="currentColor"
              viewBox="0 0 16 16"
            >
              <path d="M12.6.75h2.454l-5.36 6.142L16 15.25h-4.937l-3.867-5.07-4.425 5.07H.316l5.733-6.57L0 .75h5.063l3.495 4.633L12.601.75Zm-.86 13.028h1.36L4.323 2.145H2.865l8.875 11.633Z" />
            </svg>
          </a>
          <a
            href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(SITE_URL)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center p-2 transition-colors hover:text-ink"
            aria-label="Share on LinkedIn"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              fill="currentColor"
              viewBox="0 0 16 16"
            >
              <path d="M0 1.146C0 .513.526 0 1.175 0h13.65C15.474 0 16 .513 16 1.146v13.708c0 .633-.526 1.146-1.175 1.146H1.175C.526 16 0 15.487 0 14.854V1.146zm4.943 12.248V6.169H2.542v7.225h2.401zm-1.2-8.212c.837 0 1.358-.554 1.358-1.248-.015-.709-.52-1.248-1.342-1.248-.822 0-1.359.54-1.359 1.248 0 .694.521 1.248 1.327 1.248h.016zm4.908 8.212V9.359c0-.216.016-.432.08-.586.173-.431.568-.878 1.232-.878.869 0 1.216.662 1.216 1.634v3.865h2.401V9.25c0-2.22-1.184-3.252-2.764-3.252-1.274 0-1.845.7-2.165 1.193v.025h-.016a5.54 5.54 0 0 1 .016-.025V6.169h-2.4c.03.678 0 7.225 0 7.225h2.4z" />
            </svg>
          </a>
        </div>
      </div>
    </footer>
  );
}