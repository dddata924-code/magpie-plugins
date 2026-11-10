import * as mod from "./param-override.middleware.js"
import { check } from "../../scripts/middleware.mjs"

check(import.meta.dir, mod)
