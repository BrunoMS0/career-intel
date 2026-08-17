import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Dockerfile copies the traced server instead of node_modules, which is
  // what keeps llama-cloud-services, unpdf and the rest out of the image.
  output: "standalone",
};

export default nextConfig;
