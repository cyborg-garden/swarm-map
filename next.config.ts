import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: (process.env.ALLOWED_DEV_ORIGINS || '').split(',').filter(Boolean),
  // The app does not use next/image. Pin the image optimiser to its
  // narrowest settings so /_next/image never fetches remote URLs or
  // decodes SVG (the parser behind GHSA-2464-fhr4-w9xw).
  images: {
    dangerouslyAllowSVG: false,
    remotePatterns: [],
  },
};

export default nextConfig;
