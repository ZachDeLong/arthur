import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Engagement Platform",
  description: "Manage participants and content interactions",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
