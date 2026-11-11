import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./allergies.handlers";
import * as routes from "./allergies.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.listAllergies, handlers.listAllergies);
router.openapi(routes.recordAllergy, handlers.recordAllergy);
router.openapi(routes.removeAllergy, handlers.removeAllergy);

export default router;
