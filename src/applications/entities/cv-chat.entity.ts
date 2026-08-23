import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ChatRole, InputMode } from '../application.types';

/** One turn of the revision conversation (spec §5). */
@Entity('cv_chat')
export class CvChatEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('idx_chat_application')
  @Column({ type: 'uuid' })
  applicationId!: string;

  @Column({ type: 'text' })
  role!: ChatRole;

  @Column({ type: 'text' })
  content!: string;

  /** How the user supplied this turn. Voice is transcribed in the browser (spec §3). */
  @Column({ type: 'text' })
  inputMode!: InputMode;

  /**
   * The render this turn produced. Null on user turns. Without it a turn cannot be traced
   * to its output, and a bad revision cannot be attributed to the instruction that caused it.
   */
  @Column({ type: 'uuid', nullable: true })
  renderId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
