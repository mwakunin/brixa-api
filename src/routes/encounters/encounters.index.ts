import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./encounters.handlers";
import * as routes from "./encounters.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.openEncounter, handlers.openEncounter);
router.openapi(routes.listEncounters, handlers.listEncounters);
router.openapi(routes.getEncounter, handlers.getEncounter);
router.openapi(routes.closeEncounter, handlers.closeEncounter);
router.openapi(routes.cancelEncounter, handlers.cancelEncounter);
router.openapi(routes.admitPatient, handlers.admitPatient);
router.openapi(routes.transferPatient, handlers.transferPatient);
router.openapi(routes.dischargePatient, handlers.dischargePatient);

export default router;
