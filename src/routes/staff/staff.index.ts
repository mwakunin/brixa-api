import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./staff.handlers";
import * as routes from "./staff.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.createInvitation, handlers.createInvitation);
router.openapi(routes.listInvitations, handlers.listInvitations);
router.openapi(routes.revokeInvitation, handlers.revokeInvitation);

export default router;
