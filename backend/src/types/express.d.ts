declare global {
  namespace Express {
    interface Request {
      user?: { id: string; businessId: string; role: string };
    }
  }
}
export {};
