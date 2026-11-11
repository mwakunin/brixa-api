import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./prescriptions.handlers";
import * as routes from "./prescriptions.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.searchDrugs, handlers.searchDrugs);
router.openapi(routes.prescribe, handlers.prescribe);
router.openapi(routes.cancelPrescription, handlers.cancelPrescription);

export default router;
