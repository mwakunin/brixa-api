import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./consultation.handlers";
import * as routes from "./consultation.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.viewConsultation, handlers.viewConsultation);
router.openapi(routes.recordComplaint, handlers.recordComplaint);

export default router;
