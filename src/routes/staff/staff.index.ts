import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./staff.handlers";
import * as routes from "./staff.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.createInvitation, handlers.createInvitation);
router.openapi(routes.listInvitations, handlers.listInvitations);
router.openapi(routes.revokeInvitation, handlers.revokeInvitation);
router.openapi(routes.listMembers, handlers.listMembers);
router.openapi(routes.setLicence, handlers.setLicence);
router.openapi(routes.changeRoles, handlers.changeRoles);

export default router;
