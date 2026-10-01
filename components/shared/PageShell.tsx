/** Shared responsive width policy for every screen's outer `<main>`. Each page keeps its own
 * exact gap/padding by passing its existing className straight through — this only ever adds a
 * max-width + centering so desktop doesn't render a full-width stretch of single-column content,
 * without changing any page's own spacing, cards, or wording. `wide` is for the few screens
 * (the Menu list and product detail) asked to actually use more of the desktop width; every other
 * screen gets a comfortable, narrower reading column instead. */
export default function PageShell({ children, className = "", wide = false }: { children: React.ReactNode; className?: string; wide?: boolean }) {
  const widthClass = wide ? "md:max-w-app-wide" : "md:max-w-app-content";
  return <main className={`mx-auto w-full max-w-app ${widthClass} md:px-8 ${className}`}>{children}</main>;
}
