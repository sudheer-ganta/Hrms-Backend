import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { UserModel, UserDocument } from './user.model.js';
import { AuthResponse, CreateUserInput, IUser } from './auth.types.js';
import { ENV } from '../../config/env.js';
import { ApiError } from '../../utils/apiError.js';
import { normalizeEmpCode, isValidEmpCode } from '../../utils/empCode.js';
import { assertStrongPassword } from '../../utils/password.js';
import { requireDb } from '../../config/db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface TokenClaims {
  id: string;
  tv: number;
}

const toDto = (u: UserDocument | any): IUser => ({
  id: String(u._id),
  email: u.email,
  name: u.name,
  role: u.role,
  empCode: u.empCode || undefined,
  status: u.status,
  createdAt: u.createdAt,
});

export class AuthService {
  /**
   * First-run bootstrap ONLY. Creates the initial SUPER_ADMIN from environment
   * variables when no super admin exists at all. It never recreates, resets or
   * deletes anything afterwards, and ships no default credentials.
   */
  public async bootstrapSuperAdmin(): Promise<void> {
    if (!ENV.SEED_SUPERADMIN_EMAIL || !ENV.SEED_SUPERADMIN_PASSWORD) return;
    const existing = await UserModel.exists({ role: 'SUPER_ADMIN' });
    if (existing) {
      console.warn('[Auth] SEED_SUPERADMIN_* is set but a super admin already exists. Remove these variables from the environment.');
      return;
    }
    assertStrongPassword(ENV.SEED_SUPERADMIN_PASSWORD, ENV.SEED_SUPERADMIN_EMAIL);
    await UserModel.create({
      email: ENV.SEED_SUPERADMIN_EMAIL,
      passwordHash: await bcrypt.hash(ENV.SEED_SUPERADMIN_PASSWORD, 12),
      name: ENV.SEED_SUPERADMIN_NAME,
      role: 'SUPER_ADMIN',
      status: 'active',
    });
    console.warn(`[Auth] Initial SUPER_ADMIN created: ${ENV.SEED_SUPERADMIN_EMAIL}. Remove SEED_SUPERADMIN_* from the environment now.`);
  }

  public generateToken(user: UserDocument): string {
    const claims: TokenClaims = { id: String(user._id), tv: user.tokenVersion || 0 };
    return jwt.sign(claims, ENV.JWT_SECRET, { expiresIn: ENV.JWT_EXPIRES_IN } as jwt.SignOptions);
  }

  public verifyToken(token: string): TokenClaims | null {
    try {
      const decoded = jwt.verify(token, ENV.JWT_SECRET) as any;
      if (!decoded?.id) return null;
      return { id: String(decoded.id), tv: Number(decoded.tv ?? 0) };
    } catch {
      return null;
    }
  }

  /** Loads the CURRENT user for a token and enforces status + revocation. */
  public async authenticateToken(token: string): Promise<IUser | null> {
    const claims = this.verifyToken(token);
    if (!claims) return null;
    requireDb();
    const user = await UserModel.findById(claims.id).lean();
    if (!user || user.status !== 'active') return null;
    if ((user.tokenVersion || 0) !== claims.tv) return null;
    return toDto(user);
  }

  public async login(identifier: string, password: string): Promise<AuthResponse> {
    requireDb();
    const id = String(identifier || '').trim();
    const invalid = () => ApiError.unauthenticated('Invalid email, employee ID or password.');
    if (!id || !password) throw invalid();

    const user = EMAIL_RE.test(id)
      ? await UserModel.findOne({ email: id.toLowerCase() })
      : isValidEmpCode(id)
      ? await UserModel.findOne({ empCode: normalizeEmpCode(id) })
      : null;

    // Always run a bcrypt compare so unknown users and wrong passwords cost the same.
    const hash = user?.passwordHash || '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali';
    const ok = await bcrypt.compare(password, hash).catch(() => false);
    if (!user || !ok) throw invalid();
    if (user.status !== 'active') throw ApiError.forbidden('This account has been deactivated. Please contact the Super Admin.');

    return { token: this.generateToken(user), user: toDto(user) };
  }

  public async createUser(input: CreateUserInput): Promise<IUser> {
    requireDb();
    const email = String(input.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw ApiError.validation('A valid email is required.', [{ field: 'email', issue: 'Invalid email' }]);
    if (!(['FOUNDER', 'HR', 'EMPLOYEE'] as string[]).includes(input.role)) {
      throw ApiError.validation('Role must be FOUNDER, HR, or EMPLOYEE.', [{ field: 'role', issue: 'Invalid role' }]);
    }
    const empCode = input.empCode ? normalizeEmpCode(input.empCode) : undefined;
    if (input.role === 'EMPLOYEE' && (!empCode || !isValidEmpCode(empCode))) {
      throw ApiError.validation('A valid employee code is required for Employee accounts.', [{ field: 'empCode', issue: 'Required' }]);
    }
    assertStrongPassword(input.password, email, empCode);

    if (await UserModel.exists({ email })) throw ApiError.conflict(`An account with email ${email} already exists.`);
    if (empCode && (await UserModel.exists({ empCode }))) throw ApiError.conflict(`An account is already linked to employee code ${empCode}.`);

    let name = String(input.name || '').trim();
    if (input.role === 'EMPLOYEE' && empCode) {
      // Lazy import avoids a module cycle (employee service depends on attendance models).
      const { employeeMasterService } = await import('../employees/employeeMaster.service.js');
      const profile = await employeeMasterService.findProfile(empCode);
      if (!profile) throw ApiError.rule(`Employee ${empCode} does not exist in the employee master. Create or sync the employee first.`);
      if (!name) name = profile.name;
    }

    const created = await UserModel.create({
      email,
      passwordHash: await bcrypt.hash(input.password, 12),
      name: name || (input.role === 'FOUNDER' ? 'Founder' : input.role === 'HR' ? 'HR' : `Employee ${empCode}`),
      role: input.role,
      empCode,
      status: 'active',
    });
    return toDto(created);

  }

  public async getAllUsers(): Promise<IUser[]> {
    requireDb();
    const users = await UserModel.find({}, '-passwordHash').sort({ createdAt: -1 }).lean();
    return users.map(toDto);
  }

  public async deleteUser(userId: string, actingUserId: string): Promise<void> {
    requireDb();
    const user = await UserModel.findById(userId);
    if (!user) throw ApiError.notFound('User not found.');
    if (String(user._id) === actingUserId) throw ApiError.rule('You cannot delete your own account.');
    if (user.role === 'SUPER_ADMIN') throw ApiError.rule('A Super Admin account cannot be deleted.');
    await UserModel.findByIdAndDelete(userId);
  }

  public async toggleStatus(userId: string, actingUserId: string): Promise<IUser> {
    requireDb();
    const user = await UserModel.findById(userId);
    if (!user) throw ApiError.notFound('User not found.');
    if (String(user._id) === actingUserId) throw ApiError.rule('You cannot change your own status.');
    if (user.role === 'SUPER_ADMIN') throw ApiError.rule('A Super Admin account cannot be deactivated.');
    user.status = user.status === 'active' ? 'inactive' : 'active';
    user.tokenVersion = (user.tokenVersion || 0) + 1; // revoke existing sessions immediately
    await user.save();
    return toDto(user);
  }

  /** Admin reset. Revokes all sessions of the target user. */
  public async resetPassword(userId: string, newPassword: string): Promise<void> {
    requireDb();
    const user = await UserModel.findById(userId);
    if (!user) throw ApiError.notFound('User not found.');
    assertStrongPassword(newPassword, user.email, user.empCode);
    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
  }

  /** Self-service change; returns a fresh token because the old one is revoked. */
  public async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<AuthResponse> {
    requireDb();
    const user = await UserModel.findById(userId);
    if (!user) throw ApiError.unauthenticated();
    if (!(await bcrypt.compare(String(currentPassword || ''), user.passwordHash))) {
      throw ApiError.validation('Current password is incorrect.', [{ field: 'currentPassword', issue: 'Incorrect' }]);
    }
    assertStrongPassword(newPassword, user.email, user.empCode);
    user.passwordHash = await bcrypt.hash(newPassword, 12);
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    return { token: this.generateToken(user), user: toDto(user) };
  }

  /** Revokes every token issued to this user ("log out everywhere"). */
  public async revokeSessions(userId: string): Promise<void> {
    requireDb();
    await UserModel.updateOne({ _id: userId }, { $inc: { tokenVersion: 1 } });
  }
}

export const authService = new AuthService();
