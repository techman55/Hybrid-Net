import type { NextConfig } from "next";

const nextConfig: NextConfig = {};

export default nextConfig;

// Lets `next dev` use Cloudflare bindings; see https://opennext.js.org/cloudflare
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
