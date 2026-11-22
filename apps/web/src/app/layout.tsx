import type { Metadata, Viewport } from "next";
import { SiteFooter } from "@/components/site-footer";
import { AuthProvider } from "@/components/auth/auth-provider";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "MeroStay: Stays, buses and guides across Nepal",
    template: "%s | MeroStay",
  },
  description:
    "Plan one trip across Nepal with MeroStay: hotels and homestays, bus seats, guides and tours.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0f3b64",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh flex-col antialiased">
        <AuthProvider>
          <SiteHeader />
          <main className="flex-1">{children}</main>
          <SiteFooter />
        </AuthProvider>
      </body>
    </html>
  );
}
