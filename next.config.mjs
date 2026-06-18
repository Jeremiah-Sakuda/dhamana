/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // postgres.js and the AWS SDK are server-only; keep them out of the client bundle.
  serverExternalPackages: ["postgres", "@aws-sdk/dsql-signer"],
};

export default nextConfig;
