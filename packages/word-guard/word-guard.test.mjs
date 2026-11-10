import * as mod from "./word-guard.middleware.js"
import { check } from "../../scripts/middleware.mjs"

check(import.meta.dir, mod)
