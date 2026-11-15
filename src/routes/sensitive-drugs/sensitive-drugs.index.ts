import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./sensitive-drugs.handlers";
import * as routes from "./sensitive-drugs.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.listSensitiveDrugs, handlers.listSensitiveDrugs);
router.openapi(routes.setSensitiveDrug, handlers.setSensitiveDrug);

export default router;
