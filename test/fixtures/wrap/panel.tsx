// export default withRouter(Panel) 形式（識別子を包む HOC）
import { withRouter } from 'react-router';

const Panel = () => <div className="panel" />;

export default withRouter(Panel);
