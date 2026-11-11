import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./diagnoses.handlers";
import * as routes from "./diagnoses.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.searchIcd, handlers.searchIcd);
router.openapi(routes.recordDiagnosis, handlers.recordDiagnosis);
router.openapi(routes.listDiagnoses, handlers.listDiagnoses);
router.openapi(routes.confirmDiagnosis, handlers.confirmDiagnosis);
router.openapi(routes.makePrincipal, handlers.makePrincipal);
router.openapi(routes.endDiagnosis, handlers.endDiagnosis);

export default router;
