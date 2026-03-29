import {
  ANALYSIS_MODEL,
  DEFAULT_PORT,
  createApp,
  createServerServices,
  loadEnvironment,
  logServerStart,
  startServer,
} from "./app.js";

loadEnvironment();

const port = Number(process.env.PORT) || DEFAULT_PORT;
const apiKey = process.env.OPENAI_API_KEY;
const services = createServerServices({ apiKey });
const app = createApp(services);

startServer(app, port, () => {
  logServerStart({
    port,
    openaiConfigured: Boolean(apiKey),
    cachePath: services.cache?.getDbPath?.(),
    model: ANALYSIS_MODEL,
  });
});
