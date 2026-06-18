import Link from "next/link";

export default function NotFound() {
  return (
    <div className="container section">
      <span className="eyebrow">404</span>
      <h1>Nothing held here.</h1>
      <p>That page doesn&rsquo;t exist.</p>
      <Link href="/" className="btn btn-ghost">
        ← Back to browse
      </Link>
    </div>
  );
}
