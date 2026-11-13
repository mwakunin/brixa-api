import { createTenantRouter } from "@/lib/create-app";
import { withFacility } from "@/middlewares/tenant";

import * as handlers from "./appointments.handlers";
import * as routes from "./appointments.routes";

const router = createTenantRouter();

router.use(withFacility);

router.openapi(routes.bookAppointment, handlers.bookAppointment);
router.openapi(routes.listDay, handlers.listDay);
router.openapi(routes.moveAppointment, handlers.moveAppointment);
router.openapi(routes.cancelAppointment, handlers.cancelAppointment);
router.openapi(routes.checkIn, handlers.checkIn);
router.openapi(routes.patientAppointments, handlers.patientAppointments);
router.openapi(routes.setSmsReminders, handlers.setSmsReminders);

export default router;
