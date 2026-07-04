export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  upstreamUrl: process.env.UPSTREAM_URL || 'https://olliechat-sw02.onrender.com',
};
