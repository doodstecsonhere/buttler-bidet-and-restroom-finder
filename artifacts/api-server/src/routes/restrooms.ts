import { Router, type IRouter } from "express";
import { RESTROOMS } from "../../../../lib/restroom-data";

const router: IRouter = Router();

router.get("/restrooms", (_req, res) => {
  res.json(RESTROOMS);
});

export default router;
