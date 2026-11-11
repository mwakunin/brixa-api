import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./notes.handlers";
import * as routes from "./notes.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.startNote, handlers.startNote);
router.openapi(routes.editDraft, handlers.editDraft);
router.openapi(routes.signNote, handlers.signNote);
router.openapi(routes.discardDraft, handlers.discardDraft);
router.openapi(routes.addAddendum, handlers.addAddendum);
router.openapi(routes.markEnteredInError, handlers.markEnteredInError);
router.openapi(routes.listNotes, handlers.listNotes);

export default router;
