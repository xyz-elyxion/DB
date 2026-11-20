import { assertConfig } from "../src/config.js";
import { registerCommands } from "../src/register.js";

try {
  assertConfig();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

try {
  const { count, scope } = await registerCommands();
  console.log(`Registered ${count} command(s) ${scope}.`);
} catch (error) {
  console.error("Registration failed:", error.message);
  process.exit(1);
}
