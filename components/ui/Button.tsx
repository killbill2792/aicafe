import type { ButtonHTMLAttributes } from "react";
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export function buttonClasses(variant: ButtonVariant = "primary", className = "") {
  const variants: Record<ButtonVariant,string> = {
    primary: "bg-accent text-on-accent hover:brightness-95", secondary: "bg-surface2 text-fg hover:bg-accent-soft",
    ghost: "bg-transparent text-accent-text hover:bg-accent-soft", danger: "bg-neg text-white hover:brightness-95",
  };
  return `inline-flex min-h-12 items-center justify-center gap-2 rounded-chip px-5 py-3 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50 ${variants[variant]} ${className}`;
}
export function Button({ variant = "primary", className = "", type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {variant?: ButtonVariant}) {
  return <button {...props} type={type} className={buttonClasses(variant, className)} />;
}
