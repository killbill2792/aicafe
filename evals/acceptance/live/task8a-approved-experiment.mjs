import {runTask8a} from "./task8a-price-observation.mjs";
runTask8a(true).catch(error=>{console.error(error instanceof Error?error.message:"8a_approved_unknown");process.exitCode=1;});
