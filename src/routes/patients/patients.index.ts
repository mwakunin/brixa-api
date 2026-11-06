import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./patients.handlers";
import * as routes from "./patients.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.registerPatient, handlers.registerPatient);
router.openapi(routes.searchPatients, handlers.searchPatients);
router.openapi(routes.getPatient, handlers.getPatient);
router.openapi(routes.updatePatient, handlers.updatePatient);
router.openapi(routes.addIdentifier, handlers.addIdentifier);

export default router;
